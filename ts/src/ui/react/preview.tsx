// 右栏预览：#pbody 的主人。
//
// 这个文件出四块卡片（材料 / 实体 / 冲突 / 流程图）加产物行、占位符与 <FlowCite>，
// 另外三个 tab 由别的 track 在**自己的模块顶层**登记进 PREVIEW_TABS（见文件末尾）：
//   · q     → <QuestionWorkbench>（react/workbench.tsx）
//   · art   → <ArtifactsTab>（react/workbench.tsx）
//   · think → <ThinkTab>（react/think.tsx）
// 七个齐了，所以本模块顶层 registerRegion("pbody", PreviewBody) —— #pbody 整块归
// React，preview.ts 的 paintLegacy() 随之删掉，paint() 只剩 bumpUi()。
//
// 类名与结构逐字对齐旧模板字符串：`.files` `.f` `.cap` `.fnd` `.msheet` `.mshead`
// `.mstri` `.msname` `.msshape` `.mscount` `.msrows` `.mrow` `.kv` `.kvr` `.kvk`
// `.kvv` `.elist` `.e` `.en` `.ec` `.chunk` `.c` `.ev` `.fnode` `.fcitebox`
// `.fcite` `.fcw` `.fccode` `.fcsnip` `.acts` `.act` `.ph` `.ic` —— 少一个类名就是
// 少一块样式，那等于重新设计界面。
//
// ## 接管之后不许再做的事
//
// **一个容器只能有一个主人。** #pbody 里的任何东西都不能再由 `innerHTML=` 写 ——
// React 按自己上一次的虚拟树 diff，旧代码在它背后换掉真实 DOM 之后，下一次更新
// 轻则丢节点重则抛 NotFoundError。#fcite 就是这么被收回来的：它以前由 flowCite()
// 直接写 innerHTML，现在是 <FlowTab> 的一份局部状态。
//
// 唯一还允许命令式碰 #pbody 的是 preview.ts 的 pfade()，它改的是**容器自己**的
// class（portal 的宿主元素不归 React 管），一个子节点都不动。

import type { ReactElement, ReactNode } from "react";
import { useState } from "react";

import { API } from "../dom.js";
import { t } from "../i18n.js";
import {
  groupBySheet, loadSource, openSource, toggleSheet,
} from "../preview.js";
import { G as STATE } from "../state.js";
import { dropMaterial } from "../upload.js";
import { registerRegion } from "./app.js";
import { bumpUi, setUi, useUi } from "./store.js";

// ── 占位符 ──────────────────────────────────────────────────────
/**
 * dom.ts 的 `ph(k, t)`。**第二个参数收 ReactNode 而不是字符串** —— 旧调用点里有
 * 一处传的是 `"还没有上传材料<br><br>"`，那两个 <br> 在字符串世界里是标记，
 * 在 JSX 里必须是真元素，否则界面上会显示出「<br><br>」四个字。
 */
export function Placeholder({ ic, children }: { ic: string; children?: ReactNode }): ReactElement {
  return <div className="ph"><div className="ic">{ic}</div>{children}</div>;
}

// ── 材料 tab ────────────────────────────────────────────────────
/** 一份材料的解析状态。「这份读进来了没有」是个事实，应该看得见，而不是去问助手。 */
const MST: Record<string, (f?: any) => { t: string; c: string }> = {
  parsed:       (f: any) => ({ t: t("mat.parsed", "", { n: f.chunks }), c: "var(--accent)" }),
  partial:      (f: any) => ({ t: t("mat.partial", "", { n: f.chunks }), c: "var(--warn, #9a7a12)" }),
  failed:       () => ({ t: t("mat.failed"), c: "var(--danger, #b42318)" }),
  unsupported:  () => ({ t: t("mat.unsupported"), c: "var(--danger, #b42318)" }),
  pending:      () => ({ t: t("mat.pending"), c: "var(--warn, #9a7a12)" }),
  // 兼容旧服务端快照；新 wire shape 统一叫 pending。
  scan_pending: () => ({ t: t("mat.pending"), c: "var(--warn, #9a7a12)" }),
  unread:       () => ({ t: t("mat.unread"),      c: "var(--ink-3)" }),
};

/**
 * 材料 chip。每份带一个「×」：传错了要能在开跑前拿掉，只能重传等于逼人重开会话。
 *
 * 旧写法是 `onclick="FILE='${earg(f.name)}';loadSource('${earg(f.name)}')"` —— 文件名
 * 是用户上传时带进来的自由文本，那一层 earg 漏掉就是一次存储型 XSS。React 下参数
 * 直接是**值**，不再经过「拼进属性 → HTML 解码 → 当 JS 编译」那趟旅程。
 */
export function FileChip({ f }: { f: any }): ReactElement {
  const G = useUi();
  const st = (MST[f.state] || MST["unread"]!)(f);
  return (
    <span
      className={"f " + (f.name === G.FILE ? "on" : "")}
      title={f.issue || ""}
      onClick={() => { setUi({ FILE: f.name }); void loadSource(f.name); }}
    >{f.name}{" "}
      <i style={{ fontStyle: "normal", fontSize: "0.778rem", color: st.c, marginLeft: "5px" }}>{st.t}</i><b
        onClick={(e) => { e.stopPropagation(); void dropMaterial(f.name); }}
        title={t("mat.remove")}
        style={{ marginLeft: "6px", opacity: .45, cursor: "pointer" }}
      >×</b></span>
  );
}

/**
 * 表格行的 render 是「列名=值 | 列名=值」的长串，直接吐出来要横向找半天。
 * 拆成键值对之后，同一列在不同行是对齐的，扫一眼就知道哪个格子空着。
 *
 * 600 字的截断从**原文**上切，旧代码切的是 esc() 之后的串 —— 那会按实体的长度
 * 计数（一个 `<` 占 4 个），运气不好还会把 `&am` 切成半个实体留在页面上。
 */
export function ChunkBody({ c }: { c: any }): ReactElement {
  const txt = String(c.text || "");
  const plain = <>{txt.slice(0, 600)}</>;
  if (!txt.includes("=") || !txt.includes("|")) return plain;
  const pairs = txt.split("|").map(x => x.trim()).filter(Boolean);
  if (pairs.length < 2) return plain;
  return (
    <div className="kv">
      {pairs.map((p, i) => {
        const at = p.indexOf("=");
        if (at < 0) return <div className="kvr" key={i}><span className="kvv">{p}</span></div>;
        return (
          <div className="kvr" key={i}>
            <span className="kvk">{p.slice(0, at)}</span>{" "}
            <span className="kvv">{p.slice(at + 1)}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 一张 sheet。默认折叠、点开一张展开一张 —— 一堵 477 张卡片的墙没人看得下去；
 * 他要知道的是「这文件有几张表、各是什么」。
 */
export function SheetGroup({ g }: { g: any }): ReactElement {
  const G = useUi();
  const open = G.MAT_OPEN.has(g.sheet);
  return (
    <div className="msheet">
      <div className="mshead" onClick={() => toggleSheet(g.sheet)}>
        <span className="mstri">{open ? "▾" : "▸"}</span>
        <span className="msname">{g.sheet}</span>
        {g.shape ? <span className="msshape">{g.shape}</span> : null}
        <span className="mscount">{g.rows.length} 行</span></div>
      {open ? (
        <div className="msrows">
          {g.rows.slice(0, G.MAT_N).map((c: any, i: number) => (
            <div className="mrow" data-cite={c.cite} title={c.cite} key={i}><ChunkBody c={c} /></div>
          ))}
          {g.rows.length > G.MAT_N ? (
            <button
              className="act"
              style={{ width: "100%", marginTop: "6px" }}
              onClick={(e) => { e.stopPropagation(); STATE.MAT_N += 100; bumpUi(); }}
            >再看 100 行（共 {g.rows.length}）</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 材料 tab 的整块。空态、读取中、读取失败、正常四种形态都在这里分叉。 */
export function MaterialsTab(): ReactElement {
  const G = useUi();
  const fl = G.S.filelist || [];
  if (!fl.length) {
    return (
      <>
        <Placeholder ic="MATERIALS">还没有上传材料<br /><br /></Placeholder>
        <div style={{ textAlign: "center" }}>
          <button className="act" onClick={() => { document.getElementById("picker")?.click(); }}>选择文件</button>
        </div>
      </>
    );
  }
  // 一眼能看出还有没有没读进来的，以及该做什么
  const nPend = fl.filter((f: any) => f.state !== "parsed").length;
  const nProblem = fl.filter((f: any) => f.state === "failed" || f.state === "unsupported").length;
  const nPartial = fl.filter((f: any) => f.state === "partial").length;
  const hint = (
    <div className="cap">{!nPend ? t("mat.allRead")
      : nProblem ? t("mat.hasProblems", "", { n: nProblem })
      : nPartial ? t("mat.hasPartial", "", { n: nPartial })
      : fl.some((f: any) => f.state === "pending" || f.state === "scan_pending")
        ? t("mat.pendingScan", "", { n: nPend })
      : t("mat.pendingText", "", { n: nPend })}</div>
  );
  const doc = G.FILE ? G.SRC[G.FILE] : null;
  let body: ReactNode;
  if (!G.FILE) body = hint;
  else if (!doc) body = <div className="cap">读取中…</div>;
  else if (doc.error) body = <div className="fnd">读取失败：{doc.error}</div>;
  else {
    // 先给告警（元数据泄漏这类是 FDE 真正要看的），再给按 sheet 分组的结构。
    const cs = doc.chunks || [];
    const groups = groupBySheet(cs);
    body = (
      <>
        {(doc.findings || []).map((f: any, i: number) => <div className="fnd" key={i}>! {f.message}</div>)}
        <div className="cap">{groups.length} 张表 · {cs.length} 行</div>
        {groups.map((g: any, i: number) => <SheetGroup g={g} key={i} />)}
      </>
    );
  }
  return (
    <>
      <div className="files">{fl.map((f: any, i: number) => <FileChip f={f} key={i} />)}</div>
      {body}
    </>
  );
}

// ── 实体 tab ────────────────────────────────────────────────────
export function EntitiesTab(): ReactElement {
  const G = useUi();
  const oir = G.S.state?.oir;
  if (!oir) return <Placeholder ic="ENTITIES">梳理完成后这里显示抽取出的 ObjectType</Placeholder>;
  const st = oir.stats || {};
  return (
    <>
      <div className="cap">{st.objects || 0} 个对象 · {st.properties || 0} 个属性 · {st.links || 0} 条关系</div>
      <div className="elist">
        {oir.objects.map((o: any, i: number) => (
          <div className="e" key={i}><span className="en">{o.displayName.value}</span>{" "}
            <span className="ec">{o.apiName.value}</span></div>
        ))}
      </div>
      {oir.properties.slice(0, 40).map((p: any, i: number) => (
        <div className="chunk" key={i}><div className="c">{p.apiName.value}</div>{" "}
          {String(p.definition.value || "（无口径）").slice(0, 180)}</div>
      ))}
    </>
  );
}

// ── 冲突 tab ────────────────────────────────────────────────────
/** 证据 chip。点它回到材料原文那一行 —— 证据链要能一路点回去。 */
export function EvidenceChip({ file, cite }: { file?: string; cite: string }): ReactElement {
  return <span className="ev" onClick={() => { void openSource(file ?? "", cite); }}>◧ {cite}</span>;
}

export function ConflictsTab(): ReactElement {
  const G = useUi();
  const cs = G.S.state?.conflicts || [];
  if (!cs.length) return <Placeholder ic="CONFLICTS">梳理完成后这里显示检出的冲突</Placeholder>;
  return (
    <>
      {cs.map((c: any, i: number) => (
        <div
          className="chunk"
          key={i}
          style={{ borderColor: c.kind === "semantic_divergence" ? "var(--warn-line)" : "var(--line)" }}
        >
          <div className="c">{c.kind} · {c.handling}</div>{c.summary}{" "}
          {(c.evidence || []).slice(0, 2).map((e: any, k: number) =>
            <EvidenceChip file={e.file_name} cite={e.cite} key={k} />)}
        </div>
      ))}
    </>
  );
}

// ── 流程图 tab ──────────────────────────────────────────────────
/**
 * 点开的那个节点的出处。**旧写法把它存在 DOM 里**（flowCite() 直接写 #fcite 的
 * innerHTML），React 下它就是一份局部状态 —— 只有这一个 tab 关心它，放进 G 反而
 * 要多一个所有人都看得见、只有一个人会用的字段。
 */
export function FlowCite({ node }: { node: any }): ReactElement {
  const ev = (node.evidence && node.evidence[0]) || (node.label?.evidence && node.label.evidence[0]);
  if (!node.grounded || !ev) {
    return (
      <div className="fcite"><b>{node.label?.value || ""}</b>{" "}
        <span className="fcw">这个节点是系统推断补上的，材料里没有直接依据 —— 落地前要跟客户确认。</span></div>
    );
  }
  return (
    <div className="fcite"><b>{node.label?.value || ""}</b>{" "}
      <span className="fccode">{node.code || ""}</span>{" "}
      <EvidenceChip cite={ev.cite || ""} />
      {ev.snippet ? <div className="fcsnip">{ev.snippet}</div> : null}</div>
  );
}

export function FlowTab(): ReactElement {
  const G = useUi();
  // 选中的节点。stage + 下标是旧 flowCite(stageKey, idx) 的那两个参数，形状不变。
  const [picked, setPicked] = useState<{ stage: string; idx: number } | null>(null);
  const fl = G.S.state?.flow;
  if (!fl) return <Placeholder ic="FLOW">梳理材料后，这里显示抽出的业务流程图</Placeholder>;
  const st = fl.stats || {};
  const nodesOf = (stage: string): any[] => (fl.nodes || []).filter((n: any) => n.stage === stage);
  const grounded = (fl.nodes || []).filter((n: any) => n.grounded).length;
  const total = (fl.nodes || []).length;
  const hasMain = (G.S.state?.artifacts || []).includes("流程图_主干.svg");
  const art = (name: string): string =>
    `${API}/api/sessions/${G.S.id}/artifacts/${encodeURIComponent(name)}`;
  const pickedNode = picked ? nodesOf(picked.stage)[picked.idx] : null;
  return (
    <>
      <div className="cap">{st.actions || 0} 个动作 · {st.events || 0} 个事件 · {st.stages || 0} 个阶段 · {st.gateways || 0} 个判断 · {st.edges || 0} 条边</div>
      {/* 证据体检：每个节点有没有材料出处，一眼可见。「不是瞎编」要能核对。 */}
      <div className="cap">{grounded}/{total} 个节点有材料依据
        {st.inferred_edges ? ` · ${st.inferred_edges} 条边是推断的（虚线，需确认）` : ""}</div>
      <div className="acts" style={{ margin: "8px 0 14px", flexWrap: "wrap" }}>
        <a className="act pri" target="_blank" rel="noreferrer" href={art("流程图.svg")}>完整图</a>
        {hasMain ? <a className="act" target="_blank" rel="noreferrer" href={art("流程图_主干.svg")}>主干图</a> : null}
        <a className="act" download href={art("流程图.mmd")}>mermaid</a>
      </div>
      <div style={{ height: "6px" }}></div>
      {(fl.stages || []).map((sg: any, i: number) => (
        <div className="chunk" key={i}><div className="c">{sg.title}</div>
          {nodesOf(sg.key).map((n: any, k: number) => (
            <span
              className={"fnode " + n.kind + (n.grounded ? "" : " guess")}
              key={k}
              onClick={() => { setPicked({ stage: sg.key, idx: k }); }}
              title={n.grounded ? "点看出处" : "系统推断，无出处"}
            >{n.label?.value || ""}</span>
          ))}
        </div>
      ))}
      <div id="fcite" className="fcitebox">{pickedNode ? <FlowCite node={pickedNode} /> : null}</div>
    </>
  );
}

// ── 产物 tab（只有属于这条 track 的那几行）────────────────────────
/**
 * 产物下载行。**交付包卡片与回传审计卡不在这里** —— 它们分别归 questions 与
 * returnaudit 那两条 track，等它们交出组件之后由 <ArtifactsTab> 把三块拼起来。
 */
export function ArtifactRows(): ReactElement {
  const G = useUi();
  const arts = G.S.state?.artifacts || [];
  if (!arts.length) return <Placeholder ic="ARTIFACTS">编译出模板后这里可以下载</Placeholder>;
  return (
    <>
      {arts.map((a: string, i: number) => (
        <div className="chunk" key={i}><div className="c">{a}</div>
          <a className="act" href={`${API}/api/sessions/${G.S.id}/artifacts/${encodeURIComponent(a)}`}>下载</a></div>
      ))}
    </>
  );
}

// ── 右栏的整块 ────────────────────────────────────────────────────
/**
 * tab key → 画它的组件。**这是三条 track 的会合点**：谁把自己那个 tab 做成组件了，
 * 就在自己的模块顶层写一行 `PREVIEW_TABS.q = QuestionWorkbench;` —— 不用改这个文件，
 * 也就不会两条 track 抢同一处 diff。
 *
 * 这里只登记本模块那四个；另外三个由各自的模块补上（q / art 在 react/workbench.tsx，
 * think 在 react/think.tsx）。**它们必须被 react/regions.ts import 到** —— 模块体
 * 不执行就等于没登记，表现是那个 tab 一片空白。
 */
export const PREVIEW_TABS: Record<string, () => ReactNode> = {
  mat: MaterialsTab,
  ent: EntitiesTab,
  cf: ConflictsTab,
  flow: FlowTab,
};

/**
 * 右栏整块。
 *
 * 认不出的 tab 画空 —— 而不是退回某个默认页签：G.TAB 只可能是那七个之一（go() 是
 * 唯一的写入口），真出现第八个值时空着比假装用户点的是「材料」诚实。
 */
export function PreviewBody(): ReactNode {
  const G = useUi();
  if (!G.S) return <Placeholder ic="PREVIEW">新建会话后这里显示材料与产物</Placeholder>;
  const Tab = PREVIEW_TABS[G.TAB];
  return Tab ? <Tab /> : null;
}

// #pbody 从这一行起归 React。preview.ts 的 paint() 只剩一句 bumpUi()，
// **它的调用点一个都没动** —— 那是这次换框架能做到「行为等价」的全部依据。
registerRegion("pbody", PreviewBody);
