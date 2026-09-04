// 收件区：这一页的第一屏。
//
// ## 它在答一句具体的质问
//
// 用户的截图里，会话有 6 份材料，知识库这一页写着「0 份材料」，而页面上唯一能
// 把前者变成后者的东西，是工具条上一个没有标签的 `＋`（它旁边还有另一个 `＋▤`
// 是新建文件夹）。他的原话是「你设计的非常难用」。
//
// 那一屏的「0」并不是显示错了 —— `searchLayered` 只在 document store 上跑，
// 会话里传了但没入库的文件**根本不在索引里**。所以这一页在入库之前，除了入库
// 什么也做不了。既然如此，入库就该是第一屏最大的那个东西，而不是一个字形。
//
// ## 按钮上的字是有功能的，不许随便改
//
// 「把这 N 份材料存入知识库」这句不是文案偏好。模型侧的写操作要过
// `explicitDocumentActions`（dialogue/document_tools.ts）：入库这一类要求句子里
// 同时出现 `DOCUMENT_ACTION_COMMANDS.promote` 里的动词（存入/入库/加入知识库…）
// 和 `BATCH_QUANTIFIER` 里的量词（这些/这几份/全部/这 N 份…）。用户把这句话
// 复述给 Copilot（或点「让 Copilot 来做」预填进输入框）时，它得原样能通过那道闸。
// 写成「一键导入」「同步材料」都会让同一件事在人手上能做、在模型手上做不了。
//
// ## 为什么是串行 promote，不是一个批量接口
//
// 每一份的失败原因不一样（重名、解析不了、超限）。批量接口只能给一个结果，
// 而这里最需要说清的恰恰是「哪一份没进去、为什么」。串行 + 逐份回执，
// 慢一点，但没有一份是悄悄消失的。

import { useState, type ReactElement } from "react";

import type { KnowledgeDocument, KnowledgeDocumentVersion } from "../knowledge-library.js";
import type { KnowledgeSessionFile } from "./knowledge-library.js";

/** 一份会话文件在收件区里的样子。 */
export interface InboxItem {
  name: string;
  /** 解析状态：入库前就说，别等他做完决定再说。 */
  note: string;
  /** 已经知道读不出正文 —— 存得进去，但检索不到。 */
  weak: boolean;
}

function baseName(name: string): string {
  const cut = name.lastIndexOf(".");
  return cut > 0 ? name.slice(0, cut) : name;
}

/**
 * 会话里还没进知识库的文件。
 *
 * 判据用三条并集，因为没有一条单独可靠：
 *   · 版本的 `file_name` —— 最准（promote 原样存的就是它），但版本要额外拉，
 *     首屏可能还没到；
 *   · 文档 `title` —— promote 的默认标题就是文件名，但用户改得了标题；
 *   · 文档 `logical_name` —— promote 存的是去扩展名的文件名。
 *
 * 宁可漏报（少催一次），不可错报：把一份**已经在库里**的材料摆进收件区，
 * 用户点下去会得到一个 409 重名错误，而他做的事在他看来完全正当。
 */
export function pendingSessionFiles(
  sessionFiles: readonly KnowledgeSessionFile[],
  documents: readonly KnowledgeDocument[],
  histories: Record<string, KnowledgeDocumentVersion[] | null | undefined>,
): InboxItem[] {
  const known = new Set<string>();
  for (const doc of documents) {
    known.add(doc.title);
    known.add(doc.logical_name);
    for (const version of histories[doc.id] ?? []) known.add(version.file_name);
  }
  return sessionFiles
    .filter((file) => !known.has(file.name) && !known.has(baseName(file.name)))
    .map((file) => {
      const issue = (file.issue ?? "").trim();
      const state = (file.state ?? "").trim();
      // state / issue 这两个字段今天一路传进组件，然后一个字都不显示。
      // 「这份只读进去一半」是他**做决定之前**该知道的事，不是入库之后的惊喜。
      //
      // 用词跟着 server/material_status.ts 那套 MaterialParseState 走，一个字不自己发明：
      // 那个文件的注释把理由写死了 ——「所有出口要共用同一套优先级，否则页面说
      // '已解析'、工具却说'待识别'」。收件区是新开的一个出口，同样受这条约束。
      // 认不出来的 state 一律不显示，绝不把原始英文枚举漏到界面上。
      if (issue) return { name: file.name, note: issue, weak: true };
      const note = PARSE_NOTES[state];
      if (note) return { name: file.name, note: note[0], weak: note[1] };
      return { name: file.name, note: "", weak: false };
    });
}

/** MaterialParseState → [给人看的话, 是不是该提醒]。`parsed` 是好情况，不用说话。 */
const PARSE_NOTES: Record<string, [string, boolean] | undefined> = {
  parsed: undefined,
  partial: ["只读进去一部分", true],
  failed: ["没能解析", true],
  unsupported: ["这个格式读不了", true],
  pending: ["还没识别（扫描件要先跑视觉）", true],
  unread: ["还没读入正文", false],
};

/** 逐份回执：哪一份进去了、哪一份没有、为什么。 */
export interface InboxOutcome {
  name: string;
  ok: boolean;
  message: string;
}

export interface KnowledgeInboxProps {
  items: readonly InboxItem[];
  busy: boolean;
  outcomes: readonly InboxOutcome[];
  onIngest: (names: readonly string[]) => Promise<void>;
  onUpload: () => void;
  onDismissOutcomes: () => void;
}

export function KnowledgeInbox({
  items, busy, outcomes, onIngest, onUpload, onDismissOutcomes,
}: KnowledgeInboxProps): ReactElement | null {
  // 勾选默认全选：绝大多数情况就是「都存进去」。想挑的人再去掉几个。
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const chosen = items.filter((item) => !skipped.has(item.name));

  // 事办完了这一行就自己消失。界面不该永远替人记着已经不存在的事 ——
  // 一个恒久挂在顶上的「入库」横幅，会在库里有 200 份材料之后仍然占着第一屏。
  if (!items.length) {
    if (!outcomes.length) return null;
    const failed = outcomes.filter((row) => !row.ok);
    return <div className="od-inbox done" role="status">
      <span className="od-inbox-tick" aria-hidden="true">✓</span>
      <div>
        <strong>{failed.length
          ? `${outcomes.length - failed.length} 份已入库，${failed.length} 份没成功`
          : `都齐了 —— ${outcomes.length} 份材料已经在知识库里`}</strong>
        {failed.length ? <ul className="od-inbox-fails">
          {failed.map((row) => <li key={row.name}><b>{row.name}</b>：{row.message}</li>)}
        </ul> : null}
      </div>
      <button type="button" className="od-link" onClick={onDismissOutcomes}>知道了</button>
    </div>;
  }

  return <div className="od-inbox" aria-label="待入库的会话材料">
    <div className="od-inbox-head">
      <div>
        <strong>这次会话有 {items.length} 份材料还没进知识库</strong>
        <small>没入库的材料搜不到，Copilot 也引用不了它 —— 会话结束就跟着散了。</small>
      </div>
      {/* 这句话是模型侧那道闸认得的原话，改字之前先读文件头的说明。 */}
      <button type="button" className="act pri" disabled={busy || !chosen.length}
        onClick={() => void onIngest(chosen.map((item) => item.name))}>
        {busy ? "正在存入…" : `把这 ${chosen.length} 份材料存入知识库`}
      </button>
    </div>
    <ul className="od-inbox-list">
      {items.map((item) => {
        const off = skipped.has(item.name);
        return <li key={item.name} className={off ? "off" : ""}>
          <label>
            <input type="checkbox" checked={!off} disabled={busy}
              onChange={() => setSkipped((prev) => {
                const next = new Set(prev);
                if (next.has(item.name)) next.delete(item.name); else next.add(item.name);
                return next;
              })} />
            <span className="od-inbox-name">{item.name}</span>
          </label>
          {item.note
            ? <span className={item.weak ? "od-inbox-note weak" : "od-inbox-note"}>{item.note}</span>
            : null}
          {outcomes.find((row) => row.name === item.name && !row.ok)
            ? <span className="od-inbox-note weak">
                {outcomes.find((row) => row.name === item.name)?.message}
              </span>
            : null}
        </li>;
      })}
    </ul>
    <div className="od-inbox-foot">
      <button type="button" className="od-link" onClick={onUpload}>还要再传一些文件</button>
    </div>
  </div>;
}

export default KnowledgeInbox;
