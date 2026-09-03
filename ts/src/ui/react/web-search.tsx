import { useId, useState, type ReactNode } from "react";

import {
  WEB_SOURCE_COLLAPSED_LIMIT,
  parseWebSourcesEvent,
  type WebContentStatus,
  type WebSourceItem,
} from "../web-search.js";
import { t } from "../i18n.js";
import { WORKBENCH_OPEN_EVENT } from "./workbench-tabs.js";

const STATUS_KEY: Record<WebContentStatus, string> = {
  fetched: "web.statusFetched",
  snippet_only: "web.statusSnippet",
  blocked: "web.statusBlocked",
};

function SourceMeta({ source }: { source: WebSourceItem }): ReactNode {
  const published = source.publishedAt ? t("web.published", "", { date: source.publishedAt }) : "";
  const site = source.siteName !== source.domain ? source.siteName : "";
  const meta = [site, published].filter(Boolean);
  return meta.length ? <div className="web-source-meta">{meta.join(" · ")}</div> : null;
}

/** 一条外部来源；链接与摘要都来自 parseWebSourcesEvent 的不可信输入窄化层。 */
function SourceArticle({ source, index }: { source: WebSourceItem; index: number }): ReactNode {
  const number = String(index + 1).padStart(2, "0");
  const openInWorkbench = (): void => {
    window.dispatchEvent(new CustomEvent(WORKBENCH_OPEN_EVENT, { detail: {
      kind: "web",
      key: `web:${source.url}`,
      url: source.url,
      title: source.title,
    } }));
  };
  return (
    <li className="web-source-item" value={index + 1}>
      <article className="web-source-article" data-source-id={source.id} tabIndex={-1}
        aria-label={`${index + 1}. ${source.title}`}>
        <span className="web-source-number" aria-hidden="true">{number}</span>
        <div className="web-source-content">
          <div className="web-source-kicker">
            <span className="web-source-domain" title={source.domain}>{source.domain}</span>
            <span className={`web-source-status is-${source.contentStatus}`}>
              {t(STATUS_KEY[source.contentStatus])}
            </span>
          </div>
          <div className="web-source-link-row">
            <button type="button" className="web-source-link" onClick={openInWorkbench}
              aria-label={`在工作台打开 ${source.title}`}>{source.title}</button>
            <a className="web-source-external" href={source.url} target="_blank"
              rel="noopener noreferrer" aria-label={t("web.newWindow", "", { title: source.title })}>
              外部打开
            </a>
          </div>
          {source.snippet ? <p className="web-source-snippet">{source.snippet}</p> : null}
          <SourceMeta source={source} />
        </div>
      </article>
    </li>
  );
}

/** `web.sources` 在聊天时间线中的来源卡；无有效链接时不渲染空壳。 */
export function WebSourcesCard({ ev }: { ev: unknown }): ReactNode {
  const data = parseWebSourcesEvent(ev);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!data) return null;

  // 正文里已经引用到的来源必须立即存在于 DOM，点击 [4] 才能定位；未引用的候选结果
  // 仍按三条折叠，避免一次搜索把回答推离视口。
  const collapsedLimit = Math.min(data.results.length,
    Math.max(WEB_SOURCE_COLLAPSED_LIMIT, data.citationIds.length));
  const canExpand = data.results.length > collapsedLimit;
  const shown = expanded || !canExpand
    ? data.results
    : data.results.slice(0, collapsedLimit);
  const title = t("web.title");
  const label = data.query ? `${title}: ${data.query}` : title;
  return (
    <section className="card web-sources-card" aria-label={label}>
      <h4>{title}</h4>
      <ol className="web-source-list" id={listId} aria-label={title}>
        {shown.map((source, index) => <SourceArticle source={source} index={index}
          key={`${source.id}:${source.url}`} />)}
      </ol>
      {canExpand ? <button type="button" className="act web-source-toggle"
        aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
        {expanded ? t("table.collapse") : t("web.expandMore", "", { n: data.results.length - collapsedLimit })}
      </button> : null}
      <div className="cap web-source-note">{t("web.disclaimer")}</div>
    </section>
  );
}
