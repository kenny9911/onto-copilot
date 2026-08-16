// 上传那条路上的视图：模型下拉的选项、以及空状态里那个「开始梳理」。
//
// upload.ts 里真正碰 DOM 的只有两处：loadModels() 拼 <option>，和 uploadFiles()
// 把 `$("chip")` 写成「读取中…」。**后者不做成组件** —— `#chip` 是 index.html 里
// 一个逐字节冻结的 <span>，React 接管它就得改那段 HTML，而 767 行 CSS 与
// `.cfiles` 这个类名认的正是它。上传的网络部分（uploadFiles / uploadPicked /
// bindDrop / startBuild / setModel / dropMaterial）一行都没碰 DOM 结构，留在原处。

import type { ReactElement } from "react";
import { useEffect } from "react";

import { t } from "../i18n.js";
import { startBuild } from "../upload.js";
import { useUi } from "./store.js";

/**
 * 模型下拉的选项。「自动」= 按难度路由；选了具体模型就用它对话。**梳理管线不受
 * 影响** —— 扫描件 OCR 这类需要视觉的环节仍按能力自动挑带视觉的模型，否则选了个
 * 纯文本模型就等于把 OCR 关掉了。带视觉的在名字后面缀一个 👁。
 *
 * ## 为什么这里还有一个 useEffect
 *
 * 宿主 `<select id="modelsel">` 住在冻结的 index.html 里，React 只画它的**子节点**，
 * 拿不到 `value` 这个 prop。而 `selected` 直接写在 <option> 上是 React 明令要换掉
 * 的写法（它会把当前值的真相分散到 N 个子节点上）。所以选中态用一句命令式的
 * `sel.value = cur` 收口 —— 一处赋值，跟着每次渲染跑，和旧代码那句 `selected`
 * 的效果完全一样。
 *
 * ## 为什么还没 registerRegion("modelsel")
 *
 * index.html 里那个 <select> **自带一个 `<option value=""></option>` 占位**。
 * portal 是往容器里 append，不是替换 —— 接管之后页面上会多出一个空选项，
 * 而旧代码那句 `sel.innerHTML =` 顺手把它冲掉了。要么改 index.html（冻结的，
 * 不许），要么等 composer 那一片整体交给 React。在那之前这个组件不注册。
 */
export function ModelOptions({ hostId = "modelsel" }: { hostId?: string } = {}): ReactElement {
  const G = useUi();
  const cur: string = (G.S && G.S.model) || "";
  useEffect(() => {
    const sel = document.getElementById(hostId) as any;
    if (sel) sel.value = cur;
  });
  return (
    <>
      <option value="">{t("model.auto")}</option>
      {G.MODELS.map((m: any, i: number) => (
        <option value={m.name} key={i}>
          {m.name}{(m.capabilities || []).includes("vision") ? " 👁" : ""}
        </option>
      ))}
    </>
  );
}

/**
 * 材料读完、还没开跑时中栏那块空状态里的按钮。
 *
 * **用户点按钮本身就是确认。** 确认闸是用来挡模型自作主张花钱的，不是用来挡人的 ——
 * 挡人只会让他多点一次，然后学会无脑点确定。所以这里不再套一层「确定要开始吗」。
 */
export function StartBuildButton({ className = "sug", children = "开始梳理" }:
  { className?: string; children?: string } = {}): ReactElement {
  return <button className={className} onClick={() => { void startBuild(undefined); }}>{children}</button>;
}
