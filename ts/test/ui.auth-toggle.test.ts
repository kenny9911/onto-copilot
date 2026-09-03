/**
 * 登录框的「去注册」入口要跟着服务端的注册开关走。
 *
 * 服务端才是权威：设了 `ONTOCOPILOT_AUTH` 之后 `POST /api/register` 返回 403
 * （见 `authgate.test.ts` 的那组用例）。这里钉的是**界面别把人往那条路上引** ——
 * 谎报一个可点的"去注册"，用户填完表单只会拿到 403，而他并不知道该改去哪。
 */

import { el, resetDom } from "./ui.env.js";

import { beforeEach, describe, expect, it } from "vitest";

import { showLogin } from "../src/ui/auth.js";
import { G } from "../src/ui/state.js";

describe("登录框的注册入口", () => {
  beforeEach(() => {
    resetDom();
    G.REGISTRATION_OPEN = true;
    G.AUTH_DISMISSIBLE = false;
  });

  it("注册开着时，「去注册」可见", () => {
    showLogin("login");
    expect(el("loginToggle").style.display).toBe("");
  });

  it("注册关着时，「去注册」藏起来", () => {
    G.REGISTRATION_OPEN = false;
    showLogin("login");
    expect(el("loginToggle").style.display).toBe("none");
  });

  it("默认值是开着的 —— 拿不到 auth/status 时不该平白少掉注册入口", () => {
    expect(G.REGISTRATION_OPEN).toBe(true);
  });
});
