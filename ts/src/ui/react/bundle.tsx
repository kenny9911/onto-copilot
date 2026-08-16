// 交付包的下载入口（questions.ts 里 bundleLink() 的组件形态）。
//
// **单独一个文件是有意的**：Bundle 出现在五个地方（常驻动作栏、问题工作台的交付条、
// 回传已应用卡、回传合并事件卡、产物 tab），门禁必须五处同一份 —— 只要有一处自己
// 拼一个 <a href=…/bundle>，整道闸就白设了。所以「哪里能下载」这件事只有这一个组件
// 回答得了，源码级通扫也据此点名（见 ui.contracts.workbench.react.test.tsx）。
//
// 判据来自 releaseView()，它是 fail closed 的：有阻塞问题就 BLOCKED，哪怕会话
// 状态还写着 RELEASED。BLOCKED 时渲染出来的是 <span>，**没有 href** —— 不是一个
// 画出来再拦一下的链接，而是根本没有可点的东西；同时 aria-disabled 让读屏也听得出。

import type { ReactElement } from "react";

import { API } from "../dom.js";
import { releaseView } from "../questions.js";
import { useUi } from "./store.js";

export interface BundleLinkProps {
  label: string;
  /** 外层类名。原来 bundleLink(label, classes) 的第二个参数，默认 "act"。 */
  className?: string;
}

export function BundleLink({ label, className = "act" }: BundleLinkProps): ReactElement {
  const G = useUi();
  const release = releaseView();
  if (release.state === "BLOCKED") {
    return (
      <span className={className + " disabled"} aria-disabled="true"
        title={`${release.blockers} 个阻塞问题尚未处理；问题清单和单份草稿仍可下载`}>
        {label} · BLOCKED
      </span>
    );
  }
  const suffix = release.state === "DRAFT" ? " · DRAFT" : "";
  return (
    <a className={className} download
      href={`${API}/api/sessions/${encodeURIComponent(G.S.id)}/bundle`}
      title={release.state === "DRAFT" ? "草稿包：仍有非阻塞问题待澄清" : "已通过发布门禁"}>
      {label}{suffix}
    </a>
  );
}
