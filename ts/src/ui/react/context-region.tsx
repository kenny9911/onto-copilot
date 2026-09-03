/**
 * 新项目上下文栏的装配点。
 *
 * UI 先用当前 /state 快照立即画出来，再异步读取 /context 的权威只读聚合；这样
 * 切会话没有空白闪烁，同时 Question/Revision/Artifact 能跟 repo 中的最新状态对齐。
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { buildContextViewModel, contextSectionForTab } from "../context-model.js";
import { installContextSyncBridge } from "../context-sync.js";
import { j } from "../dom.js";
import ContextSidebar, { type ContextSidebarData } from "./context-sidebar.js";
import { registerContextSidebar } from "./preview.js";
import { useUi } from "./store.js";

type ContextResponse = Record<string, any>;

export function sidebarData(raw: ContextResponse | null, session: any, questions: any[]): ContextSidebarData {
  const source = raw ?? { ...session, questions };
  const view = buildContextViewModel(source);
  const aggregatedQuestions = Array.isArray(raw?.review?.questions) ? raw!.review.questions : [];
  // /context 是进入会话时的权威快照；/questions 则会在回答、延期、分派后立即刷新。
  // 按 id 让 live ledger 覆盖聚合快照，同时保留仅存在于聚合层的冲突/推断项。
  const mergedQuestions = new Map<string, any>();
  aggregatedQuestions.forEach((question: any, index: number) => {
    mergedQuestions.set(String(question?.id || `remote:${index}`), question);
  });
  questions.forEach((question: any, index: number) => {
    mergedQuestions.set(String(question?.id || `live:${index}`), question);
  });
  const remoteQuestions = mergedQuestions.size ? [...mergedQuestions.values()] : questions;
  return {
    revision: view.model.revision,
    // 模型组件保留原始 OIR/Flow 字段，确保所有现有 evidence / relation 语义不丢；
    // 聚合接口的稳定 view model 同时负责 revision、review 与 delivery。
    oir: session?.state?.oir || null,
    flow: session?.state?.flow || null,
    // 参考草图刻意单列：ContextSidebar 只把它用于正式 flow 为空时的只读预览，
    // 不让 buildContextViewModel 的模型计数、发布状态或交付物把它当成客户事实。
    sketch: session?.state?.sketch || null,
    questions: remoteQuestions,
    artifacts: view.delivery.artifacts,
    evidence: view.evidence.references,
  };
}

export function ContextSidebarRegion(): ReactElement {
  const G = useUi();
  const [remote, setRemote] = useState<ContextResponse | null>(null);
  const sid = G.S?.id;
  const stateVersion = G.S?.state_version ?? G.S?.stateVersion ?? G.S?.revision;

  useEffect(() => installContextSyncBridge(window), []);

  useEffect(() => {
    setRemote(null);
    if (!sid) return;
    let current = true;
    void j(`/api/sessions/${encodeURIComponent(sid)}/context`)
      .then((value) => { if (current) setRemote(value as ContextResponse); })
      // 渐进部署：旧后端没有 /context 时继续用 /state，不把右栏变成错误页。
      .catch(() => { if (current) setRemote(null); });
    return () => { current = false; };
  }, [sid, stateVersion]);

  const context = useMemo(
    () => sidebarData(remote, G.S, G.Q_BACKLOG),
    // G 是可变全局；useUi 的 version bump 会重画。这里列出真正决定 read model 的
    // 稳定字段，避免输入框每敲一个字都重新规范化整棵 OIR。
    [remote, G.S, G.Q_BACKLOG, stateVersion],
  );
  return <ContextSidebar context={context} initialSection={contextSectionForTab(G.TAB)} />;
}

registerContextSidebar(ContextSidebarRegion);
