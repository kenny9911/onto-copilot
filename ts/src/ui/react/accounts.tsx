// 账号面板的表格。动作全在 ../accounts.ts，这里只画。
//
// 结构逐字对着旧的模板字符串搬：`.err#acctErr` `.tbl` `.trow` `.trow.thead`
// `.rowacts` `.inlineform` `.act` `.act.pri` `.sgrp` `.slabel` `.field`
// `.input` `.input.sm` —— 767 行 CSS 认的就是这些。
//
// 三个 id（newUsername / newPassword / newRole / resetPwInput）保留：doAddUser 与
// doResetPassword 仍按 id 读它们。**这几个输入框因此必须是非受控的** —— 一旦给了
// `value` 就变成受控，用户敲进去的字会被 React 每次渲染抹掉。清空由 ACCT.seq
// 那个 key 负责（见 accounts.ts 的注释）。

import type { ReactElement } from "react";

import { t } from "../i18n.js";
import {
  ACCT, beginReset, cancelReset, changeRole, doAddUser, doDeleteUser,
  doResetPassword, toggleActive,
} from "../accounts.js";
import { registerRegion } from "./app.js";
import { useUi } from "./store.js";

function AccountRow({ u }: { u: any }): ReactElement {
  const G = useUi();
  return (
    <div className="trow">
      <span>{u.username}</span>
      <span>
        <select className="input sm" value={u.role}
          onChange={(e) => changeRole(u.id, e.target.value)}>
          <option value="user">{t("role.user")}</option>
          <option value="admin">{t("role.admin")}</option>
        </select>
      </span>
      <span>
        <input type="checkbox" checked={!!u.active}
          onChange={(e) => toggleActive(u.id, e.target.checked)} />
      </span>
      <span className="rowacts">
        {G.RESET_ID === u.id ? (
          <span className="inlineform">
            <input className="input sm" id="resetPwInput" type="password"
              placeholder={t("accounts.newPwPrompt")} />
            <button className="act" onClick={() => doResetPassword(u.id)}>{t("common.confirm")}</button>
            <button className="act" onClick={() => cancelReset()}>{t("common.cancel")}</button>
          </span>
        ) : (
          <button className="act" onClick={() => beginReset(u.id)}>{t("accounts.resetPw")}</button>
        )}
        <button className="act" onClick={() => doDeleteUser(u.id, u.username)}>{t("accounts.delete")}</button>
      </span>
    </div>
  );
}

export function AccountsBody(): ReactElement {
  const G = useUi();
  // 用户列表都没拉到：表格无从画起，整块换成那句错误（旧代码在这里直接把
  // $("acctBody").innerHTML 换成一个 .fnd）。
  if (ACCT.fatal) return <div className="fnd">{ACCT.fatal}</div>;
  return (
    <>
      <div className="err" id="acctErr" style={{ display: ACCT.err ? "block" : "none" }}>{ACCT.err}</div>
      <div className="tbl">
        <div className="trow thead">
          <span>{t("accounts.username")}</span>
          <span>{t("accounts.role")}</span>
          <span>{t("accounts.active")}</span>
          <span>{t("accounts.actions")}</span>
        </div>
        {G.USERS.map((u: any) => <AccountRow key={u.id} u={u} />)}
      </div>
      <div className="sgrp" key={ACCT.seq}>
        <div className="slabel">{t("accounts.add")}</div>
        <div className="field"><input className="input" id="newUsername" placeholder={t("accounts.username")} /></div>
        <div className="field"><input className="input" id="newPassword" type="password" placeholder={t("accounts.password")} /></div>
        <div className="field"><select className="input" id="newRole">
          <option value="user">{t("role.user")}</option>
          <option value="admin">{t("role.admin")}</option>
        </select></div>
        <button className="act pri" onClick={() => doAddUser()}>{t("accounts.addBtn")}</button>
      </div>
    </>
  );
}

registerRegion("acctBody", AccountsBody);
