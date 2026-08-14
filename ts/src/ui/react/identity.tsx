// 侧栏底部的身份区：账号入口 + 上弹菜单。
//
// 结构逐字对着旧的模板字符串搬：`.acctmenu#acctMenu` `.acctitem` `.acctitem.acctlang`
// `.ai` `.acctlangl` `.langsw#langsw` `.acctsep` `.acct` `.acctava` `.acctava.ghosted`
// `.acctname` `.idrole` `.acctcaret` —— 767 行 CSS 认的就是这些，`#langsw` 和
// `data-lang` 还被 applyI18n() 用来给语言开关打勾。
//
// 菜单开合改成 ACCT_MENU.open（auth.ts）：这块 DOM 现在归 React，谁都不能再在它
// 背后翻 `hidden`。

import type { ReactElement } from "react";

import { t, setLang } from "../i18n.js";
import {
  ACCT_MENU, avatarChar, closeAcctMenu, doLogout, greetName, openPassword,
  openProfile, showLogin, toggleAcctMenu,
} from "../auth.js";
import { openAccounts } from "../accounts.js";
import { openSettings } from "../settings.js";
import { registerRegion } from "./app.js";
import { useUi } from "./store.js";

export function Identity(): ReactElement | null {
  const G = useUi();
  if (!G.CURRENT_USER) return null;
  const local = G.CURRENT_USER.id === "__local__";
  const name = local ? t("auth.local") : (greetName() || G.CURRENT_USER.username);
  const ava = local ? "OC" : avatarChar(name);
  const isAdmin = G.CURRENT_USER.role === "admin";
  const lon = (l: string): string => (G.LANG === l ? "on" : "");
  return (
    <>
      <div className="acctmenu" id="acctMenu" hidden={!ACCT_MENU.open}>
        <button className="acctitem" onClick={() => { closeAcctMenu(); openSettings(); }}>
          <span className="ai">⚙</span>{t("auth.settings")}</button>
        <div className="acctitem acctlang">
          <span className="ai">文</span><span className="acctlangl">{t("auth.language")}</span>
          <span className="langsw" id="langsw">
            <button data-lang="zh" className={lon("zh")} onClick={() => setLang("zh")}>中</button>
            <button data-lang="en" className={lon("en")} onClick={() => setLang("en")}>EN</button>
          </span>
        </div>
        {!local ? (
          <button className="acctitem" onClick={() => { closeAcctMenu(); openProfile(); }}>
            <span className="ai">◐</span>{t("auth.profile")}</button>
        ) : null}
        {!local ? (
          <button className="acctitem" onClick={() => { closeAcctMenu(); openPassword(); }}>
            <span className="ai">✳</span>{t("auth.changePassword")}</button>
        ) : null}
        {isAdmin && !local ? (
          <button className="acctitem" onClick={() => { closeAcctMenu(); openAccounts(); }}>
            <span className="ai">◉</span>{t("auth.accounts")}</button>
        ) : null}
        <div className="acctsep"></div>
        {local ? (
          // **本地模式下也要有一个登录入口。** 后端的注册/登录一直是通的，但界面上
          // 只有"已经开了鉴权"这一条路会弹登录框 —— 而默认没开，于是没有任何地方
          // 能建出第一个账号，只能去命令行敲 `ontocopilot useradd`。
          <button className="acctitem" onClick={() => { closeAcctMenu(); showLogin("register", true); }}>
            <span className="ai">→</span>{t("auth.signIn")}</button>
        ) : (
          <button className="acctitem" onClick={() => doLogout()}>
            <span className="ai">⏻</span>{t("auth.logout")}</button>
        )}
      </div>
      <button className="acct" onClick={(e) => toggleAcctMenu(e)}>
        <span className={"acctava" + (local ? " ghosted" : "")}>{ava}</span>
        <span className="acctname">{name}</span>
        {!local && isAdmin ? <span className="idrole">{t("role.admin")}</span> : null}
        <span className="acctcaret">⌄</span>
      </button>
    </>
  );
}

registerRegion("identity", Identity);
