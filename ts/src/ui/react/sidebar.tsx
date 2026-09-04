// 侧栏那一块（`#convs`）：会话行、项目文件夹分组、未归类垫底。
//
// 接手的是 sessions.ts 里的 `paintSessions()` 与 `convRow()` 两个拼串函数 ——
// 它们已经从那边删掉了，每一行都登记在 tools/verify-ui-port.mjs 的 REACT_REPLACED 里。
// `paintSessions()` 本身**留着**（名字与调用点一个都没动），函数体换成
// syncProjectChrome() + bumpUi()：前者管的是 `#pjnewBtn`，那颗按钮长在冻结的 HTML 上、
// 不归 React；后者通知这个 region 重画。
//
// ## 类名与结构逐字对着旧字符串抄
//
// 767 行 CSS 认的是 `.conv` `.conv.on` `.t` `.s` `.mv` `.del` `.pjgroup` `.pjhead`
// `.pjhead.off` `.pjcaret` `.pjname` `.pjn` `.pjadd` `.pjmore` `.pjbody` `.pjempty`
// `.pjsec` `.pjcreate` `.cap` 这一整套选择器。这里每一个都对着旧模板字符串核过 ——
// 少一个类名就是少一块样式，那等于改设计。
//
// 用户点名要保的三件事，各自的落点：
//   · **展开/折叠**：`PJ_OFF`（state.ts）里记的是「收起了哪些」，折起来时整个
//     `.pjbody` 不渲染，`.pjhead` 加 `off`（`.pjcaret` 的旋转靠它）。计数 `.pjn`
//     在收起状态下照样画 —— 收起来之后仍然看得出里面有几条。
//   · **未归类置底**：它是**最后**一个 `.pjgroup`，且和真项目共用同一套收展存储
//     （key 是 `UNFILED`）。只进不出的文件夹是个陷阱，所以它同样是放置目标。
//   · **会话卡片的层级**：会话行永远住在 `.pjbody` 里面，缩进来自 CSS 而不是内联样式。
//
// ## 拖拽：处理器收到的是元素，不再是 `this`
//
// 旧写法 `ondragover="dragOver(event,this)"` 里的 `this` 是浏览器给内联处理器绑的
// 那个元素；React 下对应 `e.currentTarget`。projects.ts 里那几个函数一个字没改，
// 它们要的本来就是「事件 + 元素」。
//
// 拖拽高亮（`.dragover` / `.dragging`）仍由那几个函数直接 classList 增删。React 不会
// 把它擦掉：className **prop** 没变时 React 根本不碰这个属性。这是刻意的 —— 一次拖拽
// 期间的临时高亮做成状态，要为它引一个 bumpUi 风暴，而收益是零。

import type { DragEvent, MouseEvent, ReactElement, ReactNode } from "react";

import { fmtWhen } from "../dom.js";
import { t } from "../i18n.js";
import {
  dragEnd, dragOut, dragOver, dragSession, dropOnProject, dropOnUnfiled,
  newProject, newSessionIn, projectMenu, sessionMenu, toggleProject,
} from "../projects.js";
import { dropSession, openSession, renameSession, statusText } from "../sessions.js";
import { PJ_OFF, UNFILED } from "../state.js";
import { registerRegion } from "./app.js";
import { openKnowledgePage } from "./knowledge-page.js";
import { useUi } from "./store.js";

/** 嵌套按钮：外层 .conv 整行可点，里面的按钮不能顺带把会话也打开。 */
const stop = (e: MouseEvent): void => { e.stopPropagation(); };

export function ConvRow({ s }: { s: any }): ReactElement {
  const G = useUi();
  const meta = G.MODE === "chat" ? t("sidebar.chatMeta")
    : `${statusText(s.status)} · ${t("mat.count", "", { n: s.files })}`;
  // 拖拽只在工作模式 + 后端有 /api/projects 时开（和旧代码同一个判据）。
  const drag = G.PROJECTS_OK && G.MODE === "work";
  return (
    <div
      className={"conv" + (G.S && s.id === G.S.id ? " on" : "")}
      onClick={() => openSession(s.id)}
      {...(drag ? {
        draggable: true,
        onDragStart: (e: DragEvent) => dragSession(e, s.id),
        onDragEnd: (e: DragEvent) => dragEnd(e),
      } : {})}
    >
      <div
        className="t"
        title={t("session.renameTip")}
        onDoubleClick={(e) => { stop(e); renameSession(s.id); }}
      >{s.title}</div>
      <div className="s">{meta}{s.created ? " · " + fmtWhen(s.created) : ""}</div>
      {drag && (
        <button
          className="mv"
          title={t("project.moveTo")}
          onClick={(e) => { stop(e); sessionMenu(e, s.id); }}
        >⋯</button>
      )}
      <button
        className="del"
        title="删除会话"
        onClick={(e) => { stop(e); dropSession(s.id, s.title); }}
      >×</button>
    </div>
  );
}

/** 平铺的一段会话。空的时候给一行说明 —— 那行文案按模式分（聊天/工作）。 */
function Flat({ list, hint }: { list: any[]; hint: string }): ReactNode {
  if (!list.length) return <div className="cap" style={{ padding: "0 10px" }}>{hint}</div>;
  return list.map((s: any) => <ConvRow key={s.id} s={s} />);
}

/**
 * 一个项目文件夹。`onToggle` / `onDrop` 由调用方给 —— 「未归类」是同一种外形、
 * 不同的归属判据，共用这一个组件比再抄一遍结构安全。
 */
function ProjectGroup({ off, name, n, onToggle, onDrop, head, children }: {
  off: boolean;
  name: string;
  n: number;
  onToggle: () => void;
  onDrop: (e: DragEvent) => void;
  /** 项目才有的那两颗按钮（＋ / ⋯）。未归类不传。 */
  head?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="pjgroup">
      <div
        className={"pjhead" + (off ? " off" : "")}
        onClick={onToggle}
        onDragOver={(e) => dragOver(e, e.currentTarget)}
        onDragLeave={(e) => dragOut(e.currentTarget)}
        onDrop={onDrop}
      >
        <span className="pjcaret">▾</span>
        <span className="pjname">{name}</span>
        <span className="pjn">{n}</span>
        {head}
      </div>
      {off ? null : <div className="pjbody">{children}</div>}
    </div>
  );
}

export function Sidebar(): ReactNode {
  const G = useUi();
  const emptyHint = G.MODE === "chat" ? t("sidebar.emptyChat") : t("sidebar.emptyWork");

  // 平铺只在**两种情况**下发生：聊天模式（不进项目），或后端没有 /api/projects
  // （老版本 server）。**工作模式下即使一个项目都没有也要出分区结构** ——
  // 否则这个功能要等到"你已经有项目了"才现身，而新用户永远迈不出第一步：
  // 侧栏和从前一模一样，唯一入口是一个不起眼的 ＋。
  if (G.MODE !== "work" || !G.PROJECTS_OK) return <Flat list={G.SESSION_LIST} hint={emptyHint} />;

  const currentProject = G.PROJECTS.find((project: any) => project.id === G.S?.project_id);
  // 知识库**恒可打开**，而且默认落在「有我材料的那一层」。
  //
  // 原来的判据是 `currentProject ? "project" : "global"` —— 会话没归项目就送去
  // 公共库。可材料是跟着会话走的：那条路把一个刚传完 6 份文件的人，送进一个
  // 结构上不可能装着这 6 份的库，然后让界面对他说「0 份材料」。
  // 后端 document_scope.ts 会给没归项目的会话懒建「我的材料」，所以只要有会话，
  // 项目层就是有内容的那一层。公共库仍在页头一键可达。
  const label = currentProject?.name ?? (G.S?.id ? "我的材料" : "公共");
  const knowledgeEntry = <button
    type="button"
    className={`side-knowledge-entry${G.MAIN_PAGE === "knowledge" ? " on" : ""}`}
    title={G.S?.id ? `打开「${label}」的知识库` : "打开公共知识库"}
    onClick={() => openKnowledgePage(G.S?.id ? "project" : "global")}
  >
    <span className="side-knowledge-icon" aria-hidden="true">▤</span>
    <span><strong>知识库</strong><small>{label}</small></span>
  </button>;

  if (!G.PROJECTS.length) return (
    <>
      {knowledgeEntry}
      <div className="pjsec">{t("project.section")}</div>
      <button className="pjcreate" onClick={() => newProject(null)}>{t("project.createFirst")}</button>
      <div className="pjsec">{t("project.unfiled")}</div>
      <Flat list={G.SESSION_LIST} hint={emptyHint} />
    </>
  );

  const known = new Set(G.PROJECTS.map((p: any) => p.id));
  // project_id 指向一个这里看不见的项目（刚被别处删掉、或不属于我）时也归「未归类」——
  // 宁可多露一次面，也不能让一个会话从侧栏凭空消失。
  const loose = G.SESSION_LIST.filter((s: any) => !known.has(s.project_id || ""));
  return (
    <>
      {knowledgeEntry}
      {G.PROJECTS.map((p: any) => {
        const mine = G.SESSION_LIST.filter((s: any) => (s.project_id || "") === p.id);
        return (
          <ProjectGroup
            key={p.id}
            off={PJ_OFF.has(p.id)}
            name={p.name}
            n={mine.length}
            onToggle={() => toggleProject(p.id)}
            onDrop={(e) => dropOnProject(e, p.id)}
            head={<>
              <button
                className="pjadd"
                title={t("project.newSessionHere")}
                onClick={(e) => { stop(e); newSessionIn(p.id); }}
              >+</button>
              <button
                className="pjmore"
                onClick={(e) => { stop(e); projectMenu(e, p.id); }}
              >⋯</button>
            </>}
          >
            {mine.length
              ? mine.map((s: any) => <ConvRow key={s.id} s={s} />)
              : <div className="cap pjempty">{t("project.empty")}</div>}
          </ProjectGroup>
        );
      })}
      {/* 「未归类」也是一组，同样能收起来。会话攒到几十个之后，一个收不起来的分区会把
          下面的项目全顶出屏幕 —— 那时候"分好类了"反而更难找东西。 */}
      <ProjectGroup
        off={PJ_OFF.has(UNFILED)}
        name={t("project.unfiled")}
        n={loose.length}
        onToggle={() => toggleProject(UNFILED)}
        onDrop={(e) => dropOnUnfiled(e)}
      >
        {loose.length
          ? loose.map((s: any) => <ConvRow key={s.id} s={s} />)
          : <div className="cap pjempty">{
              G.SESSION_LIST.length ? t("project.noUnfiled") : emptyHint}</div>}
      </ProjectGroup>
    </>
  );
}

// `#convs` 从此归 React。容器本身（那个 `<div class="convs" id="convs">`）还是
// index.html 里现成的那个，React 只往里面画。
registerRegion("convs", Sidebar);
