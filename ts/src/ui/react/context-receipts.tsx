import { useSyncExternalStore, type ReactElement } from "react";

import {
  contextSyncStore,
  quoteContextReceiptToComposer,
  selectRecentContextReceipts,
  type ContextChangeReceipt,
} from "../context-sync.js";
import { togglePreview } from "../layout.js";
import { setUi, useUi } from "./store.js";

function openReceipt(receipt: ContextChangeReceipt): void {
  contextSyncStore.focusReceipt(receipt.id, "receipt");
  setUi({ TAB: receipt.section, CONTEXT_BACK: null });
  const panel = document.getElementById("preview");
  if (panel?.classList.contains("hidden")) togglePreview();
}

/**
 * 已经写入项目上下文的操作回执。
 *
 * 它刻意不是一颗聊天气泡：FDE 要能区分「人/AI 说了什么」和「系统已经把什么写进
 * 当前 revision」。引用按钮只把一段可见的摘要放进输入框，绝不自动发送。
 *
 * **这里曾经还有一张「当前侧栏引用」卡**（activeReference + 引用到输入框/打开/清除）。
 * 删了 —— 它在聊天流里只是复述侧栏已经显示着的东西，占一整行却不提供新信息。
 * `contextSyncStore` 的 focus/activeReference/clearFocus 一并保留：侧栏本来就该订阅它
 * 做「聊天点一条 → 侧栏定位到那条」，那条链目前还没接完（侧栏里没有 useSyncExternalStore），
 * 删掉 store 等于把将来要做的接线点也铲了。
 */
export function ContextReceipts(): ReactElement | null {
  const G = useUi();
  const snapshot = useSyncExternalStore(
    contextSyncStore.subscribe,
    contextSyncStore.getSnapshot,
    contextSyncStore.getSnapshot,
  );
  const receipts = selectRecentContextReceipts(snapshot, { sessionId: G.S?.id, limit: 3 });
  if (!receipts.length) return null;

  return <div className="context-chat-bridge">
    {receipts.length ? <aside className="context-receipts" aria-label="项目上下文更新">
      <div className="context-receipts-head">
        <strong>项目上下文已更新</strong>
        <span>{receipts.length} 条新回执</span>
      </div>
      <div className="context-receipts-list">
      {receipts.map((receipt) => <div className="context-receipt" key={receipt.id}>
        <span className="context-receipt-mark" aria-hidden="true"></span>
        <div className="context-receipt-copy">
          <strong>{receipt.title}</strong>
          <span>{receipt.summary || `${receipt.section} · ${receipt.revision}`}</span>
        </div>
        <div className="context-receipt-actions">
          <button type="button" onClick={() => { quoteContextReceiptToComposer(receipt); }}>引用到下一轮</button>
          <button type="button" onClick={() => openReceipt(receipt)}>查看</button>
          <button type="button" aria-label={`关闭回执：${receipt.title}`}
            onClick={() => { contextSyncStore.dismissReceipt(receipt.id); }}>关闭</button>
        </div>
      </div>)}
      </div>
    </aside> : null}
  </div>;
}

export default ContextReceipts;
